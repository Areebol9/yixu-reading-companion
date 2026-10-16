package com.yixu.reading;
import java.util.Arrays;
import java.util.List;

public class ReadingLayoutCheck {
    static ReadingLayout.Line line(int left,int top,int right,int bottom,int chars){return new ReadingLayout.Line(left,top,right,bottom,chars);}
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args){
        List<ReadingLayout.Line> page=Arrays.asList(line(10,10,970,50,20),line(150,85,970,125,18),line(10,140,390,180,9),line(10,220,970,260,20));
        check(ReadingLayout.singleColumn(page,1000,400),"Indented paragraphs and short closing lines are one column");
        check(!ReadingLayout.singleColumn(page.subList(0,2),1000,400),"Sparse observations do not establish page coverage");
        check(!ReadingLayout.singleColumn(Arrays.asList(line(10,10,450,50,10),line(540,10,990,50,10),line(10,80,450,120,10),line(540,80,990,120,10)),1000,400),"Two columns must keep separate fragments");
        check(!ReadingLayout.singleColumn(Arrays.asList(line(0,0,970,40,20),line(10,10,970,50,20),line(0,90,970,130,20)),1000,400),"Overlapping OCR rows are ambiguous");
        check(!ReadingLayout.singleColumn(Arrays.asList(line(0,0,970,40,20),line(0,70,970,110,20),line(0,400,970,440,20)),1000,500),"A large unexplained break is not continuous flow");
        check(!ReadingLayout.singleColumn(page,1000,130),"Clipped rows do not prove the remaining frame");
        System.out.println("Reading layout: single-column coverage and ambiguous layouts checked");
    }
}
